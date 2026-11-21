import type { MarketFamily } from "@/lib/markets";
import { runContinuousEngine } from "./continuousEngine";
import { runJumpEngine } from "./jumpEngine";
import { runStepEngine } from "./stepEngine";
import type { EngineInput, EngineOutput } from "./types";

export function runEngine(family: MarketFamily, input: EngineInput): EngineOutput {
  if (family === "continuous") return runContinuousEngine(input);
  if (family === "step") return runStepEngine(input);
  return runJumpEngine(input);
}
