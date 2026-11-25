package mindmodel.engine.dump;

import java.util.Map;
import java.util.TreeMap;

/**
 * The failures the dump answers with an empty answer instead of an error, counted by a short reason key
 * (`refs.typeUnresolved`). One per run, owned by {@link Dump#run} and written into meta.json's counts, so a run
 * says what it could not read rather than hiding it.
 */
final class Failures {

    private final Map<String, Integer> counts = new TreeMap<>();

    /** One more failure under `key`. */
    void count(String key) {
        counts.merge(key, 1, Integer::sum);
    }

    /** The counts so far, sorted by key. */
    Map<String, Integer> counts() {
        return counts;
    }
}
