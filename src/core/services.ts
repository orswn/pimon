/**
 * Typed services that features expose to features that depend on them.
 * Each feature adds its entry with declaration merging:
 *
 *   declare module "../../core/services.ts" {
 *     interface ServiceMap { notify: NotifyService }
 *   }
 */
export interface ServiceMap {}
