import * as WebExt from "webextension-polyfill";

declare global {
  const browser: typeof WebExt;
  const bwipjs: any;
  const importScripts: undefined | ((...urls: string[]) => void);
  
  interface Window {
    bcadd?: (left: string, right: string) => string;
    bcmul?: (left: string, right: string) => string;
    bcdiv?: (left: string, right: string) => string;
  }

  const API_BOARDING_PASS_URL: string;
  const API_DOWNLOAD_PASS_URL: string;
  const API_ORDERS_URL: string;
  const CACHE_TTL_MS: number;
}
