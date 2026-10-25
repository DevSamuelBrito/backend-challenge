import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureEnvironment, connectDatabase, discoverInstances } from "./cluster";
import { renderCorrectness, writeReport } from "./report";
import { runRound, type ScenarioResult } from "./runner";
import { loadSettings } from "./settings";

const REPORT_PATH = join(import.meta.dir, "..", "..", "docs", "LOAD_TEST.md");
const RESULTS_DIR = join(import.meta.dir, "results");
const EXIT_VERIFICATION_FAILED = 1;
const EXIT_SETUP_FAILED = 2;

const hasFailure = (results: readonly ScenarioResult[]) =>
  results.some((result) => result.checks.some((entry) => !entry.ok));

async function main(): Promise<number> {
  const settings = loadSettings();
  const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const instances = await discoverInstances(settings.minInstances);
  const sql = await connectDatabase();
  const results: ScenarioResult[] = [];

  try {
    const environment = await captureEnvironment(instances, sql, settings);

    console.log(
      `Execução ${runId}: ${instances.length} instâncias (${instances.map((i) => i.port).join(", ")}), ${settings.rounds} rodada(s), concorrência ${settings.concurrency}`,
    );

    for (let round = 1; round <= settings.rounds; round += 1) {
      await runRound({ instances, sql, settings, runId }, round, results);
    }

    mkdirSync(RESULTS_DIR, { recursive: true });
    writeFileSync(
      join(RESULTS_DIR, `${runId}.json`),
      JSON.stringify({ runId, environment, results }, null, 2),
    );
    writeReport(REPORT_PATH, environment, results, settings.rounds);

    console.log("\nRelatório atualizado em docs/LOAD_TEST.md\n");
    console.log(renderCorrectness(results));

    return hasFailure(results) ? EXIT_VERIFICATION_FAILED : 0;
  } catch (error) {
    console.error(
      `\nTeste de carga abortado: ${error instanceof Error ? error.message : String(error)}`,
    );

    return hasFailure(results) ? EXIT_VERIFICATION_FAILED : EXIT_SETUP_FAILED;
  } finally {
    await sql.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(
      `\nTeste de carga não iniciou: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(EXIT_SETUP_FAILED);
  });
