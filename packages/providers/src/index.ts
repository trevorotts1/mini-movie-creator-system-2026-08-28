export const MMCS_PROVIDERS = "@mmcs/providers scaffold marker";

// Real public surface (SKR-012).
//
// This file used to contain ONLY the marker line above, while 164 source files across the
// Agnes, Fish Audio and Kie provider integrations sat in subdirectories reachable only via
// the package subpath export. A root import therefore resolved to a module exporting one
// string: a silent no-op rather than an error.
//
// Namespaced re-exports rather than flat `export *` — provider modules reuse names
// (client, config, validation appear under several families), so flat re-exports would
// not compile and would hide the collisions at call sites.
export * as AgnesClient from "./agnes/client/index.js";
export * as AgnesProfilesEdit from "./agnes/profiles/edit/index.js";
export * as AgnesProfilesFlash from "./agnes/profiles/flash/index.js";
export * as AgnesProfilesImage from "./agnes/profiles/image/index.js";
export * as AgnesProfilesRegular from "./agnes/profiles/regular/index.js";
export * as AgnesQuota from "./agnes/quota/index.js";
export * as AgnesRetry from "./agnes/retry/index.js";
export * as AgnesValidation from "./agnes/validation/index.js";
export * as AgnesVideoPoll from "./agnes/video/poll/index.js";
export * as AgnesVideoSubmit from "./agnes/video/submit/index.js";
export * as FishAudioAlignment from "./fish-audio/alignment/index.js";
export * as FishAudioCache from "./fish-audio/cache/index.js";
export * as FishAudioCaptions from "./fish-audio/captions/index.js";
export * as FishAudioClient from "./fish-audio/client/index.js";
export * as FishAudioConfig from "./fish-audio/config/index.js";
export * as FishAudioMix from "./fish-audio/mix/index.js";
export * as FishAudioNormalize from "./fish-audio/normalize/index.js";
export * as FishAudioPronunciation from "./fish-audio/pronunciation/index.js";
export * as FishAudioTts from "./fish-audio/tts/index.js";
export * as FishAudioVoiceProfiles from "./fish-audio/voice-profiles/index.js";
export * as KieClient from "./kie/client/index.js";
export * as KieBudget from "./kie/budget/index.js";
export * as KieCost from "./kie/cost/index.js";
export * as KieErrors from "./kie/errors/index.js";
export * as KieSeedance from "./kie/seedance/index.js";
export * as KieSeedanceValidation from "./kie/seedance/validation/index.js";
export * as KieTask from "./kie/task/index.js";
export * as KieTempUrl from "./kie/temp-url/index.js";
export * as KieWan from "./kie/wan/index.js";
export * as KieWanValidation from "./kie/wan/validation/index.js";
