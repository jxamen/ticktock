// Monorepo + Expo setup. Two goals:
//
// 1. Force Metro to resolve react/react-native/etc. from this package only,
//    so the agent's React 18 (hoisted to the repo root) doesn't shadow our
//    React 19 here. Duplicate React instances break hooks, context, and
//    produce cryptic "Cannot read property 'S' of undefined" crashes.
//
// 2. Still let Metro watch the workspace root so imports from
//    `@ticktock/shared` keep working (the package lives one level up).

const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
