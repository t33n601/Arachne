export { VERSION } from "./version.js";

// Parsing
export {
  Node,
  NodeList,
  SelectorSyntaxError,
  defaultTrackFile,
  type NodeOptions,
  type SelectOptions,
  type XPathOptions,
  type FindArgument,
} from "./parser.js";
export { TextValue, TextValueList, AttributeMap, type ReOptions, type RegexInput } from "./core/text.js";
export { TrackStore, SqliteTrackStore, elementToDict, type ElementData, type TrackStoreFactory } from "./core/storage.js";
export { ContentExtractor, type ExtractionType } from "./core/extract.js";
export { log, rootLogger, Logger, LogLevel, withLogger } from "./core/logger.js";
export { parseCurl } from "./core/curl.js";

// Fetching
export {
  Http,
  AsyncHttp,
  HttpSession,
  Browser,
  BrowserSession,
  AsyncBrowserSession,
  StealthBrowser,
  StealthBrowserSession,
  AsyncStealthBrowserSession,
  ProxyRotator,
  cyclicRotation,
  isProxyError,
} from "./clients/index.js";
export { Response, BaseClient, StatusText, type NodeConfig, type BrowserCookie } from "./transport/utils/response.js";
export {
  UnsafeRedirectError,
  type RequestOptions as HttpRequestOptions,
  type HttpSessionOptions,
  type ImpersonateType,
  type FollowRedirects,
} from "./transport/http.js";
export type {
  PlaywrightSessionOptions,
  StealthSessionOptions,
  PlaywrightFetchOptions,
  SetCookieParam,
} from "./transport/browsers/config.js";
export type { ProxyType, RotationStrategy } from "./transport/utils/proxy-rotation.js";
