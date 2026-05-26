// Parse Docker image references the way the Docker daemon does.
//
// Replaces the naive `lastIndexOf(":")` split that breaks for
// port-bearing registries with untagged refs (e.g. `localhost:5000/img`
// parsed as image=`localhost`, tag=`5000/img`).
//
// Output shape covers what callers need today (pulling images) and what
// they will need next (looking up registry credentials and building the
// X-Registry-Auth header).

const DOCKER_HUB_HOST = "docker.io";
const DOCKER_HUB_SERVER_ADDRESS = "https://index.docker.io/v1/";

export type ParsedImageRef = {
  /** Registry host used to look up credentials. Docker Hub refs return
   *  "docker.io" even though that string never appears in the ref. */
  registryHost: string;
  /** Value for the `serveraddress` field in the X-Registry-Auth payload.
   *  Docker Hub has a special URL; all other registries use the bare host. */
  serverAddress: string;
  /** Value to send as the `fromImage` query param to the daemon. For
   *  digest refs this includes the `@sha256:...` suffix. */
  fromImage: string;
  /** Value to send as the `tag` query param, or null to omit it. Null
   *  for digest refs (daemon ignores tag when fromImage carries a digest). */
  tag: string | null;
};

/** Parse a Docker image reference. Throws on malformed input
 *  (empty string, trailing colon with no tag, trailing @ with no digest). */
export function parseImageRef(ref: string): ParsedImageRef {
  if (!ref) throw new Error("invalid image reference: empty");

  // Digest takes priority over tag. Per Docker Engine API, when
  // fromImage carries a digest the tag query param is ignored.
  let digest: string | null = null;
  let withoutDigest = ref;
  const atIndex = ref.indexOf("@");
  if (atIndex !== -1) {
    digest = ref.slice(atIndex); // includes the leading "@"
    if (digest === "@") {
      throw new Error(`invalid image reference: empty digest in "${ref}"`);
    }
    withoutDigest = ref.slice(0, atIndex);
    if (!withoutDigest) {
      throw new Error(`invalid image reference: missing image name in "${ref}"`);
    }
  }

  // Identify the registry. The first slash-separated segment is the
  // registry iff it contains "." or ":" or equals "localhost"; otherwise
  // the whole thing is a Docker Hub image name.
  let registryHost: string;
  let remainder: string;
  const slashIdx = withoutDigest.indexOf("/");
  if (slashIdx !== -1) {
    const head = withoutDigest.slice(0, slashIdx);
    if (head.includes(".") || head.includes(":") || head === "localhost") {
      registryHost = head;
      remainder = withoutDigest.slice(slashIdx + 1);
    } else {
      registryHost = DOCKER_HUB_HOST;
      remainder = withoutDigest;
    }
  } else {
    registryHost = DOCKER_HUB_HOST;
    remainder = withoutDigest;
  }

  if (!remainder) {
    throw new Error(`invalid image reference: missing image name in "${ref}"`);
  }

  // Split image:tag in the remainder. The remainder has no registry
  // prefix and no digest, so the only colon (if any) introduces a tag.
  let imageName = remainder;
  let tag: string | null = null;
  const colonIdx = remainder.lastIndexOf(":");
  if (colonIdx !== -1) {
    const candidateTag = remainder.slice(colonIdx + 1);
    if (!candidateTag) {
      throw new Error(`invalid image reference: empty tag in "${ref}"`);
    }
    // A colon followed by "/" isn't a tag separator. Defensive: should
    // not occur because we stripped the registry head above.
    if (!candidateTag.includes("/")) {
      imageName = remainder.slice(0, colonIdx);
      tag = candidateTag;
    }
  }

  if (!imageName) {
    throw new Error(`invalid image reference: missing image name in "${ref}"`);
  }

  const isDockerHub = registryHost === DOCKER_HUB_HOST;
  const fromImage = digest
    ? isDockerHub
      ? `${imageName}${digest}`
      : `${registryHost}/${imageName}${digest}`
    : isDockerHub
      ? imageName
      : `${registryHost}/${imageName}`;

  const outputTag = digest ? null : (tag ?? "latest");
  const serverAddress = isDockerHub ? DOCKER_HUB_SERVER_ADDRESS : registryHost;

  return { registryHost, serverAddress, fromImage, tag: outputTag };
}
