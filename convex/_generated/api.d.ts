/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as announcements from "../announcements.js";
import type * as auth from "../auth.js";
import type * as email from "../email.js";
import type * as hub from "../hub.js";
import type * as hubCollections from "../hubCollections.js";
import type * as members from "../members.js";
import type * as publicAnnouncements from "../publicAnnouncements.js";
import type * as publicHubCollections from "../publicHubCollections.js";
import type * as publicSurveys from "../publicSurveys.js";
import type * as seed from "../seed.js";
import type * as surveys from "../surveys.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  announcements: typeof announcements;
  auth: typeof auth;
  email: typeof email;
  hub: typeof hub;
  hubCollections: typeof hubCollections;
  members: typeof members;
  publicAnnouncements: typeof publicAnnouncements;
  publicHubCollections: typeof publicHubCollections;
  publicSurveys: typeof publicSurveys;
  seed: typeof seed;
  surveys: typeof surveys;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
