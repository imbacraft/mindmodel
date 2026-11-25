import { linesMatching } from '../core/strings.mjs';
import { anyNamed, listOf, patternOf } from '../catalogs/catalog.mjs';
import { modelEntries } from './model-entries.mjs';
import { backgroundOf } from './background.mjs';

// The framework names this reads are in catalogs/vocabulary.json, so the readers below name no framework themselves.

/** Runtime machinery, from the model: an annotation, a supertype, a call or a field's type, never a line of source. */
export function runtimeMachinery(appTypes, views) {
  const interceptors = modelEntries(appTypes, {
    types: {
      ann: [anyNamed('interceptor-annotations')],
      supers: patternOf('interceptor-supers'),
    },
    methods: {
      ann: [anyNamed('around-invoke-annotations')],
      returns: patternOf('interceptor-registration-type'),
      calls: anyNamed('interceptor-registration-calls'),
    },
  });
  const contextScopes = modelEntries(appTypes, {
    types: { ann: [anyNamed('request-scope-annotations')] },
    methods: { ann: [anyNamed('method-scope-annotations')] },
    // A static ThreadLocal is the request- or caller-scoped slot the app keeps its context in.
    fields: { type: patternOf('thread-local-type') },
  });
  const exceptionHandlers = [
    ...new Set(
      appTypes
        .filter(
          (t) =>
            (t.supers ?? []).some((s) => patternOf('exception-mapper-supers').test(s.fqn ?? s.text ?? '')) ||
            (t.methods ?? []).some((m) =>
              (m.ann ?? []).some((a) => listOf('exception-handler-annotations').has(a.name)),
            ),
        )
        .map((t) => t.file),
    ),
  ];
  const baseClasses = Object.entries(
    appTypes.reduce((acc, t) => {
      const b = String((t.supers ?? []).find((s) => s.kind !== 'interface')?.text ?? '').replace(/<.*/, '');
      if (b && !patternOf('base-class-exclusions').test(b)) acc[b] = (acc[b] ?? 0) + 1;
      return acc;
    }, {}),
  )
    .filter(([, n]) => n >= 3)
    .map(([b, n]) => ({ base: b, subclasses: n }));
  // Session state: an attribute written or read on the HTTP session, and the @SessionAttributes declaration. A view
  // that reads `sessionScope.x` is not Java, and stays a view-file fact, not a runtime one.
  const sessionState = modelEntries(appTypes, {
    types: { ann: [anyNamed('session-attribute-annotations')] },
    methods: { calls: anyNamed('session-attribute-calls'), recv: patternOf('session-holder-type') },
  })
    .concat(
      views.flatMap((v) =>
        linesMatching(v.text, patternOf('session-view-reads')).map((m) => ({ file: v.p, ...m })),
      ),
    )
    .slice(0, 80);
  return { interceptors, contextScopes, exceptionHandlers, baseClasses, sessionState };
}

/** The runtime machinery the model shows, and the work that runs without a request. */
export function runtimeAndBackground(ctx, types, endpoints, views) {
  return {
    runtime: runtimeMachinery(types.appTypes, views),
    background: backgroundOf(ctx, types, endpoints),
  };
}
