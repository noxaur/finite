import { index, layout, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  layout("routes/shell.tsx", [
    route("about", "routes/about.tsx"),
    route("posts/:postId", "routes/post.tsx"),
  ]),
] satisfies RouteConfig;
