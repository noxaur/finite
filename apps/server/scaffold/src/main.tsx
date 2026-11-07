import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import Home from "./routes/Home.tsx";
import "./styles.css";

/** Every page of the app. Finite shows each route as a frame on the Routes page. */
export const routes = [{ path: "/", element: <Home /> }];

const router = createBrowserRouter(routes);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
