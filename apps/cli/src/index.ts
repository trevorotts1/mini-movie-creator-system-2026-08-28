#!/usr/bin/env node
import { Command } from "commander";

const program = new Command();

program
  .name("mmcs")
  .description("Mini Movie Creator System — stable, scriptable CLI (spec §24)");

// --- pipeline lifecycle ---
program.command("doctor").description("Check environment, providers, and config health");
program.command("status").description("Show project/series/episode state and approval gates");
program.command("create-series").description("Create a new series with persistent defaults");
program.command("create-episode").description("Create a new episode in a series");
program
  .command("develop-concept")
  .description("Develop a concept for approval (STOP at concept gate)");
program.command("approve concept").description("Approve the developed concept");
program
  .command("write-script")
  .description("Write the script for the episode (STOP at script gate)");
program.command("approve script").description("Approve the written script");
program.command("cast").description("Generate character candidates");
program
  .command("choose-character <candidate>")
  .description("Choose a character candidate for refinement");
program.command("approve-character <id>").description("Approve a character version");
program.command("storyboard").description("Generate storyboard/shot plan");
program.command("approve-storyboard").description("Approve the storyboard");
program
  .command("estimate")
  .description("Estimate cost and duration of the generation plan");
program.command("generate").description("Generate all shots for the episode");
program.command("generate-shot <id>").description("Generate a single shot");
program.command("retry-shot <id>").description("Retry a failed shot");
program.command("qc").description("Run QC on generated assets");
program
  .command("rough-cut")
  .description("Assemble the rough cut (STOP at rough-cut gate)");
program.command("approve rough-cut").description("Approve the rough cut");
program.command("final").description("Produce the final render");
program.command("canon review").description("Review series canon/continuity");
program.command("canon approve").description("Approve canon updates");

// --- providers, models, characters, storage ---
program.command("providers").description("List configured providers");
program
  .command("providers verify")
  .description("Verify configured/documented/observed capability per provider");
program.command("models").description("List models available per provider");
program.command("character list").description("List characters in the library");
program.command("character show <id>").description("Show a character and its versions");
program.command("storage status").description("Show media storage backend status");

// --- recovery ---
program.command("recover").description("Resume interrupted pipeline work safely");

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});