import http from "node:http";

const port = Number(process.env.API_PORT);
if (!port) throw new Error("Set API_PORT to the port the api listens on.");

http
  .createServer((request, response) => {
    response.setHeader("access-control-allow-origin", "*");
    if (request.url === "/health") return response.end("ok");
    if (request.url === "/hello") return response.end("Hello from the api");
    response.statusCode = 404;
    response.end("not found");
  })
  .listen(port, "127.0.0.1", () => console.log(`api listening on http://127.0.0.1:${port}`));
