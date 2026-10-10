// The build this server runs. The same value is inlined into the browser
// bundle, so a page can tell when the server moved on and it must reload.
export const BUILD = process.env.NEXT_PUBLIC_WB_BUILD || "dev";
