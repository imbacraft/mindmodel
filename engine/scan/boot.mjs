import { bootEntries, bootFacts } from '../extract/boot.mjs';
import { git } from '../io/git.mjs';
import { anyNamed } from '../catalogs/catalog.mjs';
import { linesMatching } from '../core/strings.mjs';
import { modelEntries } from './model-entries.mjs';

/** Profile and conditional switches: the annotations that choose a bean or profile, and the profile lines in config. */
function switchesOf(appTypes, configFiles, R, read) {
  const switches = anyNamed('switch-annotations');
  return modelEntries(appTypes, {
    types: { ann: [switches] },
    methods: { ann: [switches] },
  }).concat(
    configFiles.flatMap((f) =>
      linesMatching(read(f), /profiles?\.active|on-profile/).map((m) => ({ file: R(f), ...m })),
    ),
  );
}

/** How the app runs: the build's run facts, the entry points and the profile switches. */
export function bootOf(ctx, types, configFiles) {
  const { root, model, files, R, read, app } = ctx;
  return {
    computed: bootFacts({ root, files, rel: R, git, app, read }),
    ...bootEntries({ model, files, rel: R, read, configFiles }),
    switches: switchesOf(types.appTypes, configFiles, R, read),
  };
}
