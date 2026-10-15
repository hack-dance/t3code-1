import { useAtomValue } from "@effect/atom-react";
import { cliReleaseByTagUrl } from "@t3tools/shared/cliRelease";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { AsyncResult, Atom } from "effect/reactivity";

const isRelease = Schema.is(
  Schema.Struct({
    tag_name: Schema.String,
    draft: Schema.Boolean,
    assets: Schema.Array(Schema.Struct({ name: Schema.String })),
  }),
);

/** A published HD release with checksums is available to server installers.
 * Missing releases and failed requests are retried without a page reload. */
export const releasePublishedAtom = Atom.family((version: string) =>
  Atom.make(
    Effect.gen(function* () {
      const response = yield* HttpClient.get(cliReleaseByTagUrl(version));
      if (response.status === 404) return false;
      const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
        Effect.flatMap((ok) => ok.json),
      );
      return (
        isRelease(body) &&
        !body.draft &&
        body.tag_name === `v${version}` &&
        body.assets.some((asset) => asset.name === "SHA256SUMS")
      );
    }).pipe(
      // Public release checks need no credentials or tracing headers.
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.provide(FetchHttpClient.layer),
    ),
  ).pipe(
    Atom.withRefresh("5 minutes"),
    Atom.keepAlive,
    Atom.withLabel(`release-published:${version}`),
  ),
);

const NO_VERSION_ATOM = Atom.make(AsyncResult.success(false)).pipe(
  Atom.withLabel("release-published:none"),
);

/** True once the HD release and its archive checksums are published. */
export function useReleasePublished(version: string | null): boolean {
  const result = useAtomValue(version ? releasePublishedAtom(version) : NO_VERSION_ATOM);
  return AsyncResult.getOrElse(result, () => false);
}
