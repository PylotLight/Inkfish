/// <reference types="vite/client" />

import type { PreloadAPI } from "../../preload/index";

declare global {
  interface Window {
    api: PreloadAPI;
  }
}

declare module "*?url" {
  const url: string;
  export default url;
}
