import { resetAnswers } from "./report-store.mjs";

// Start every run from an empty answer log so a report can never mix results
// from two runs.
export default function globalSetup() {
  resetAnswers();
}
