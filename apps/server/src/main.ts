import { createAgents } from "./agent/index.ts";
import { startServer } from "./app.ts";
import { readConfig } from "./config.ts";
import { createPreviews } from "./preview/index.ts";
import { createSourceEditor } from "./source/index.ts";
import { createStore } from "./store/index.ts";

const config = readConfig(process.env, process.cwd());

const store = createStore({ dataDir: config.dataDir });
const previews = createPreviews({ host: config.host, allowedHosts: config.allowedHosts });
const source = createSourceEditor({ routes: (design) => previews.routes(design.id) });
const agents = createAgents({ store, previews, source });

const server = await startServer({
  port: config.port,
  host: config.host,
  allowedHosts: config.allowedHosts,
  staticDir: config.staticDir,
  modules: { store, previews, source, agents },
});
console.log(`finite server on ${server.url} (data in ${config.dataDir})`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void server.close().finally(() => process.exit(0));
  });
}
