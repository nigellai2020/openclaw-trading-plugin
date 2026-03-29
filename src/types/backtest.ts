export type BacktestNormalizedTimeRange = {
  startTime: string;
  endTime: string;
  timeZoneUsed: string;
  timeZoneSource:
    | "explicit-timezone-parameter"
    | "runtime-timezone"
    | "explicit-input-offset";
};

export type ParsedLocalDateTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
};

export type BacktestNormalizedTime = {
  iso: string;
  usedExplicitOffset: boolean;
  explicitOffset?: string;
};
