/**
 * Feature flags for the advanced tools. All four are on. Set one to `false` to hide the tool behind a preview
 * screen (from `screens/tools/locked/`) with a "Soon" badge in More.
 */
export const features = {
  receipts: true, // PDF rent receipts and rental agreements
  meterReadings: true, // Photo-based electricity and water meter readings
  automations: true, // Meter reading → bill → receipt → reminder workflows
  reports: true, // Income, expenses, profit, occupancy insights
} as const;

export type FeatureKey = keyof typeof features;
