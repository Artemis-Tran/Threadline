import "dotenv/config";

function main() {
  console.log("Threadline scaffolding is up.");

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("ANTHROPIC_API_KEY is not set (add it to .env).");
  } else {
    console.log("ANTHROPIC_API_KEY loaded from .env.");
  }
}

main();
