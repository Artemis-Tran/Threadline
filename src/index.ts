import "dotenv/config";
import { DEFAULT_MODEL, resolveModel } from "./models";
import { apiKeyEnvVar } from "./extraction-call";

function main() {
  console.log("Threadline scaffolding is up.");

  // Which credential to report is derived from the default model's provider,
  // not hardcoded: the default is an OpenAI row now (ADR-0009), and a scaffolding
  // check that names ANTHROPIC_API_KEY would tell a correctly configured user
  // their key is missing. An extraction run derives its own key the same way,
  // from the model actually asked for.
  const envVar = apiKeyEnvVar(resolveModel(DEFAULT_MODEL).provider);

  if (!process.env[envVar]) {
    console.log(`${envVar} is not set (add it to .env). Needed by the default model, ${DEFAULT_MODEL}.`);
  } else {
    console.log(`${envVar} loaded from .env.`);
  }
}

main();
