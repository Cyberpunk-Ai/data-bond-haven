import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
  const queryClient = new QueryClient();

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    // Prefetch a route's code-split chunk (and its loader, for the few share
    // routes that have one) the moment the pointer/focus lands on a link, so
    // clicking a nav item feels instant instead of stalling on a chunk + data
    // fetch. Pages without loaders only pay for the JS chunk, which the browser
    // caches — no extra backend traffic for the main feed/explore/profile tabs.
    defaultPreload: "intent",
    // Keep a just-preloaded route fresh briefly so the hover→click round trip is
    // reused rather than immediately refetched (a staleTime of 0 undid preload).
    defaultPreloadStaleTime: 30_000,
  });

  return router;
};
