import {json} from "micro";
import {URL} from "url";
import types from "mysql/lib/protocol/constants/types";
import odbc from "odbc";

const getSparkDriver = () => {
  if (process.platform === "linux") {
    return "/opt/simba/spark/lib/64/libsparkodbc_sb64.so";
  }
  if (process.platform === "darwin") {
    return "/Library/simba/spark/lib/libsparkodbc_sbu.dylib";
  }
  throw new Error("Not sure what OS we're running on...");
}

const makeConnectionString = (config) =>
  Object.entries(config)
    .map(([key, value]) => `${key}=${value}`)
    .join(";");

/**
 * A handler has a default export that accepts the URL to the database, and then returns a middleware function for the query (with standard req/res paramters). The middleware request has a JSON body with the SQL query (`sql`) and parameters (`params`), while the response should be streamed JSON with a `data` array of rows, and a `schema` object describing the columns.
 * 
 * The `data` array should just be a JSON array of rows, with each row being an object with the column names as keys.
 * The `schema` object needs to be wrapped in `{type: "array", items: {type: "object", properties: {...}}}`, where `properties` is an object with the column names as keys, and data types as values. The data types have a complicated format that can be reviewed by looking at other examples of handlers in this package.
 */
export default (url) => {
  // http://socrates-gateway.us-east-1.prod.atl-paas.net:443/workspaces/atlassian-discover/jdbc
  url = new URL(url);
  const {hostname, port, pathname} = new URL(url);

  console.log(`Connecting to ${hostname}:${port}${pathname}`);

  // https://developer.atlassian.com/platform/socrates/socrates-gateway/service/connecting-non-jvm/
  const connectionString = makeConnectionString({
    Driver: getSparkDriver(),
    "http.header.X-Slauth-Egress": true,
    HOST: hostname,
    PORT: port,
    HTTPPath: pathname,
    SSL: 1,
    SparkServerType: 3,
    Schema: "default",
    TransportMode: "http",
    ThriftTransport: 2,
    UseNativeQuery: 1,
    AuthMech: 1,
    KrbHostFQDN: "slauth.prod.atl-paas.net",
    KrbServiceName: "HTTP",
    KrbRealm: "OFFICE.ATLASSIAN.COM",
    KrbAuthType: 2,
  });

  console.log(`Connection string: ${connectionString}`);

  const connectionPromise = odbc.connect(connectionString);

  return async function query(req, res) {
    const connection = await connectionPromise;
    console.log("Connected to ODBC");
    const {sql, params} = await json(req);

    console.log(`Got ${sql}`)

    // https://github.com/markdirish/node-odbc#result-array
    // This is an array with one entry per row.
    // It also has parameters for the schema etc.
    const results = await connection.query(sql, params);
    
    // Copy the array but strip out the properties.
    const data = [...results];

    // An array of `{ name: string, dataType: number }` pairs.
    const { columns } = results;
    const schema = {
      type: "array",
      items: {
        type: "object",
        properties: columns.reduce(
          (schema, { name, dataType }) => (
            (schema[name] = dataTypeSchema(dataType)), schema
          ),
          {}
        )
      }
    }

    res.end(JSON.stringify({data, schema}));
  }
};

const boolean = ["null", "boolean"],
  integer = ["null", "integer"],
  number = ["null", "number"],
  object = ["null", "object"],
  string = ["null", "string"];
function dataTypeSchema({type, charsetNr}) {
  switch (type) {
    case types.BIT:
      return {type: boolean};
    case types.TINY:
    case types.SHORT:
    case types.LONG:
      return {type: integer};
    case types.INT24:
    case types.YEAR:
    case types.FLOAT:
    case types.DOUBLE:
    case types.DECIMAL:
    case types.NEWDECIMAL:
      return {type: number};
    case types.TIMESTAMP:
    case types.DATE:
    case types.DATETIME:
    case types.NEWDATE:
    case types.TIMESTAMP2:
    case types.DATETIME2:
    case types.TIME2:
      return {type: string, date: true};
    case types.LONGLONG: // TODO
      return {type: string, bigint: true};
    case types.TINY_BLOB:
    case types.MEDIUM_BLOB:
    case types.LONG_BLOB:
    case types.BLOB:
    case types.VAR_STRING:
    case types.VARCHAR:
    case types.STRING:
      return charsetNr === 63 // binary
        ? {type: object, buffer: true}
        : {type: string};
    case types.JSON:
      return {type: object};
    case types.TIME: // TODO
    case types.ENUM: // TODO
    case types.SET: // TODO
    case types.GEOMETRY: // TODO
    case types.NULL: // TODO
    default:
      return {type: string};
  }
}