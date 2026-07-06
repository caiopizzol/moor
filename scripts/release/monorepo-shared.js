import fs from "node:fs";
import path from "node:path";
import { getRoot } from "semantic-release-monorepo/src/git-utils.js";
import logPluginVersion from "semantic-release-monorepo/src/log-plugin-version.js";
import { withFiles } from "semantic-release-monorepo/src/only-package-commits.js";
import {
  mapCommits,
  mapNextReleaseVersion,
  withOptionsTransforms,
} from "semantic-release-monorepo/src/options-transforms.js";
import versionToGitTag from "semantic-release-monorepo/src/version-to-git-tag.js";
import { wrapStep } from "semantic-release-plugin-decorators";

// CLI and MCP prepack bundles include packages/contract source. Contract-only
// changes must therefore trigger releases for those consuming packages.
const DEFAULT_SHARED_PATHS = ["packages/contract"];
const WRAPPER_NAME = "semantic-release-monorepo";

const normalizeGitPath = (value) => {
  const normalized = path.normalize(value).replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized === "" ? "." : normalized;
};

const pathSegments = (value) => {
  const normalized = normalizeGitPath(value);
  return normalized === "." ? [] : normalized.split("/").filter(Boolean);
};

const fileIsUnderPath = (releasePath, filePath) => {
  const releaseSegments = pathSegments(releasePath);
  if (releaseSegments.length === 0) return true;

  const fileSegments = pathSegments(filePath);
  return releaseSegments.every((segment, index) => segment === fileSegments[index]);
};

const uniquePaths = (paths) => Array.from(new Set(paths.map(normalizeGitPath)));

const getSharedSourcePaths = (env = process.env) => {
  const rawPaths = env.MOOR_RELEASE_SHARED_PATHS;
  if (rawPaths === undefined) return DEFAULT_SHARED_PATHS;

  return rawPaths
    .split(",")
    .map((sharedPath) => sharedPath.trim())
    .filter(Boolean);
};

const getReleasePaths = (packagePath, env = process.env) =>
  uniquePaths([packagePath, ...getSharedSourcePaths(env)]);

const findPackageJsonPath = (fromDirectory = process.cwd()) => {
  let directory = path.resolve(fromDirectory);

  while (true) {
    const packageJsonPath = path.join(directory, "package.json");
    if (fs.existsSync(packageJsonPath)) return packageJsonPath;

    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error(`Could not find package.json from ${fromDirectory}`);
    }
    directory = parent;
  }
};

const readPackageName = () => {
  const packageJsonPath = findPackageJsonPath();
  return JSON.parse(fs.readFileSync(packageJsonPath, "utf8")).name;
};

const getPackagePath = async () => {
  const packageJsonPath = findPackageJsonPath();
  const gitRoot = await getRoot();

  return normalizeGitPath(path.relative(gitRoot, path.dirname(packageJsonPath)));
};

const onlyReleasePathCommits = async (commits) => {
  const packagePath = await getPackagePath();
  const releasePaths = getReleasePaths(packagePath);
  const commitsWithFiles = await withFiles(commits);

  return commitsWithFiles.filter(({ files }) => isCommitInReleasePaths(releasePaths, files));
};

const tapAsync = (fn) => async (value) => {
  await fn(value);
  return value;
};

const pipeAsync =
  (...functions) =>
  async (initialValue) => {
    let value = initialValue;
    for (const fn of functions) {
      value = await fn(value);
    }
    return value;
  };

const composeWrappers =
  (...wrappers) =>
  (plugin) =>
    wrappers.reduceRight((wrappedPlugin, wrapper) => wrapper(wrappedPlugin), plugin);

const logFilteredCommitCount =
  (logger) =>
  async ({ commits }) => {
    logger.log(
      "Found %s commits for package %s since last release",
      commits.length,
      readPackageName(),
    );
  };

const withOnlyReleasePathCommits = (plugin) => async (pluginConfig, config) => {
  const { logger } = config;

  return plugin(
    pluginConfig,
    await pipeAsync(
      mapCommits(onlyReleasePathCommits),
      tapAsync(logFilteredCommitCount(logger)),
    )(config),
  );
};

const analyzeCommits = wrapStep(
  "analyzeCommits",
  composeWrappers(logPluginVersion("analyzeCommits"), withOnlyReleasePathCommits),
  {
    wrapperName: WRAPPER_NAME,
  },
);

const generateNotes = wrapStep(
  "generateNotes",
  composeWrappers(
    logPluginVersion("generateNotes"),
    withOnlyReleasePathCommits,
    withOptionsTransforms([mapNextReleaseVersion(versionToGitTag)]),
  ),
  {
    wrapperName: WRAPPER_NAME,
  },
);

const success = wrapStep(
  "success",
  composeWrappers(
    logPluginVersion("success"),
    withOnlyReleasePathCommits,
    withOptionsTransforms([mapNextReleaseVersion(versionToGitTag)]),
  ),
  {
    wrapperName: WRAPPER_NAME,
  },
);

const fail = wrapStep(
  "fail",
  composeWrappers(
    logPluginVersion("fail"),
    withOnlyReleasePathCommits,
    withOptionsTransforms([mapNextReleaseVersion(versionToGitTag)]),
  ),
  {
    wrapperName: WRAPPER_NAME,
  },
);

const tagFormat = `${readPackageName()}-v\${version}`;

const isCommitInReleasePaths = (paths, commitFiles) =>
  commitFiles.some((filePath) =>
    paths.some((releasePath) => fileIsUnderPath(releasePath, filePath)),
  );

export {
  analyzeCommits,
  fail,
  generateNotes,
  getReleasePaths,
  getSharedSourcePaths,
  isCommitInReleasePaths,
  success,
  tagFormat,
};
