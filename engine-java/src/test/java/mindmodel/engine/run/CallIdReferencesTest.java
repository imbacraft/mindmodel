package mindmodel.engine.run;

import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Path;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * A call's id is named by every row that refers to the call: a local's {@code from}, a {@code call} on an argument,
 * a comparison, a return, a field write, a method reference. Each of those must name a call row that the dump writes,
 * and the id must be the one that row carries, placed where that row is.
 */
class CallIdReferencesTest {

    @TempDir
    Path dir;

    private static final String SOURCE = """
            package demo;
            public class Refs {
                static final String TAG = String.valueOf(1);
                private final Object held = build();
                private String state = (String) first();
                Object build() { return new Object(); }
                Object first() { return "x"; }
                String run(String input, Object raw) {
                    String local = input.trim();
                    String again = String.valueOf((Object) local).trim();
                    String chosen = input == null ? local : String.valueOf(raw);
                    state = String.valueOf(raw);
                    java.util.function.Supplier<String> s = () -> String.valueOf(raw);
                    Object anon = new Object() {
                        public String toString() { return String.valueOf(input).trim(); }
                    };
                    String sw = switch (input.length()) { case 1 -> String.valueOf(1); default -> input.trim(); };
                    java.util.List<String> names = java.util.Arrays.asList(input).stream().map(String::trim).toList();
                    if (String.valueOf(raw).equals(chosen)) state = again;
                    return helper(String.valueOf(again), state.trim()) + local + s.get() + anon + sw + names;
                }
                String helper(String a, String b) { return a; }
                String pick(Object o) {
                    return switch (o.hashCode()) { case 1 -> String.valueOf(o); default -> String.valueOf(held); };
                }
                String ret(String x) { return x.trim(); }
            }
            """;

    /** Every id a row names is a call row's id, and every call row's id is the one its own place gives. */
    @Test
    void everyCallIdAReferenceNamesIsACallRow() throws Exception {
        DumpRun run = DumpRun.of(dir, Map.of("demo/Refs.java", SOURCE));
        List<JsonNode> calls = run.rows("calls");
        Set<String> ids = new HashSet<>();
        for (JsonNode call : calls) {
            String id = call.path("id").asText();
            assertTrue(ids.add(id), "call id is unique: " + id);
            String method = call.path("method").asText();
            String place = method + "@" + call.path("line").asInt() + ":" + call.path("col").asInt();
            assertTrue(id.equals(place) || id.matches(java.util.regex.Pattern.quote(place) + "~\\d+"),
                    "a call's id is its method and its own position: " + id + " at " + place);
        }
        Set<String> referenced = new HashSet<>();
        for (String section : List.of("members", "calls", "fields"))
            for (JsonNode row : run.rows(section)) collectCallReferences(row, referenced);
        assertTrue(referenced.size() >= 8, "the fixture names calls from many kinds of row: " + referenced);
        for (String id : referenced) assertTrue(ids.contains(id), "a reference names no call row: " + id);
    }

    /**
     * Collects every call id a row names: a {@code call} key, and a {@code from} that holds an id (one with an
     * {@code @}; a field's id has none and a {@code new} names a type).
     */
    private static void collectCallReferences(JsonNode node, Set<String> out) {
        if (node.isObject()) {
            node.fields().forEachRemaining(entry -> {
                JsonNode value = entry.getValue();
                boolean named = entry.getKey().equals("call")
                        || entry.getKey().equals("from") && value.asText().contains("@");
                if (named && value.isTextual()) out.add(value.asText());
                collectCallReferences(value, out);
            });
        } else if (node.isArray()) {
            for (JsonNode child : node) collectCallReferences(child, out);
        }
    }
}
