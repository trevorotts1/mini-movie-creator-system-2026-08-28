// @mmcs/api — thin service-boundary stub.
// Exposes the same operations as the CLI over HTTP; honors approval gates.
// No implementation yet: Wave 1 owns the contracts (spec §24, §59).

export const API_SERVICE_BOUNDARY = {
  name: "@mmcs/api",
  version: "0.1.0",
  description:
    "Thin HTTP service boundary over the MMCS engine. CLI and API map to the same domain operations.",
  endpoints: [] as string[],
};