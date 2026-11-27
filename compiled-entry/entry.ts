const modes = ["serve", "relay", "check"] as const;
const [first] = process.argv.slice(2);
const mode = modes.find((candidate) => candidate === first);

if (mode) {
  console.log(`entry:${mode}`);
} else if (first === "--version") {
  console.log("entry:version");
} else {
  console.log(`entry:other:${process.argv.slice(2).join(" ")}`);
  process.exitCode = 64;
}
