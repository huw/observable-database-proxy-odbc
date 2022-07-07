import {json} from "micro";
import {URL} from "url";
import odbc from "odbc";
import {Readable} from "stream";
import JSONStream from "JSONStream";

const getSparkDriver = () => {
  if (process.platform === "linux") {
    return "/opt/simba/spark/lib/64/libsparkodbc_sb64.so";
  }
  if (process.platform === "darwin") {
    return "/Library/simba/spark/lib/libsparkodbc_sbu.dylib";
  }
  throw new Error("Not sure what OS we're running on...");
};

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

  // We can't await the pool promise on init, so await it on each query.
  const connectionPoolPromise = odbc.pool(connectionString);

  return async function query(req, res) {
    const connection = await (await connectionPoolPromise).connect();
    console.log("Connected to ODBC");
    const {sql, params} = await json(req);

    console.log(`Got ${sql}`);

    // https://github.com/markdirish/node-odbc#result-array
    // This is an array with one entry per row.
    // It also has parameters for the schema etc.
    const results = await connection.query(sql, params);

    // Copy the array but strip out the properties.
    const data = [...results];

    const dataStream = Readable.from(data);

    await new Promise((resolve, reject) => {
      dataStream
        .on("end", resolve)
        .on("error", reject)
        .pipe(
          JSONStream.stringify(`{"data":[`, ",", "]", undefined, (_, value) =>
            // Fix for serialising BigInts
            typeof value === "bigint" ? value.toString() : value
          )
        )
        .pipe(res, {end: false});
    });

    // An array of `{ name: string, dataType: number }` pairs.
    const {columns} = results;
    const schema = {
      type: "array",
      items: {
        type: "object",
        properties: columns.reduce(
          (schema, {name, dataType}) => (
            (schema[name] = dataTypeSchema(dataType)), schema
          ),
          {}
        ),
      },
    };

    res.end(`,"schema":${JSON.stringify(schema)}}`);
  };
};

const array = ["null", "array"],
  boolean = ["null", "boolean"],
  integer = ["null", "integer"],
  number = ["null", "number"],
  object = ["null", "object"],
  string = ["null", "string"];
function dataTypeSchema(type) {
  switch (type) {
    // https://github.com/microsoft/ODBC-Specification/blob/b7ef71fba508ed010cd979428efae3091b732d75/Windows/inc/sql.h#L198
    // We also have to add a few more that the ODBC spec doesn't know about, but Spark sends back out. We figured these out from a mix of inspection & seeing what Copilot spit out. These are all the negative-numbered codes here.
    case -7: // SQL_BIT
      return { type: boolean };
    case -6: // SQL_BIGINT
      return { type: string, bigint: true };
    case -4: // SQL_BINARY
    case -3: // SQL_VARBINARY
    case -2: // SQL_LONGVARBINARY
      return { type: object, buffer: true };
    case -1: // SQL_NULL
    case 0: // SQL_UNKNOWN_TYPE or SQL_VARIANT_TYPE
    case 17: // SQL_UDT
    case 19: // SQL_ROW
      return { type: object };
    case 2: // SQL_NUMERIC
    case 3: // SQL_DECIMAL
    case 6: // SQL_FLOAT
    case 7: // SQL_REAL
    case 8: // SQL_DOUBLE
      return { type: number };
    case 4: // SQL_INTEGER
    case 5: // SQL_SMALLINT
    case -5: // SQL_SMALLINT
      return { type: integer };
    case 9: // SQL_DATETIME
    case 91: // SQL_TYPE_DATE
    case 92: // SQL_TYPE_TIME
    case 93: // SQL_TYPE_TIMESTAMP
    case 94: // SQL_TYPE_TIME_WITH_TIMEZONE
    case 95: // SQL_TYPE_TIMESTAMP_WITH_TIMEZONE
      return { type: string, date: true };
    case 50: // SQL_ARRAY
    case 55: // SQL_MULTISET
      // Using `{ type: object }` as in the Snowflake connector.
      return { type: array, items: { type: object } };
    case 1: // SQL_CHAR
    case 12: // SQL_VARCHAR
    case -8: // SQL_LONGVARCHAR
    case -9: // SQL_WCHAR
    case -10: // SQL_WVARCHAR
    case -11: // SQL_WLONGVARCHAR
    default: // Default to string, usually a better shot than `object`.
      return { type: string };
  }
}
