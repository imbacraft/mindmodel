package mindmodel.engine.resolve;

import java.io.IOException;
import java.io.InputStream;
import java.util.LinkedHashMap;
import java.util.Map;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * The one declared extension to what a source-only compiler knows: `(type, method) -> return type` for library calls
 * whose receiver is only reachable through a chain (`jmsContext.createProducer().send(...)`). It is data in the jar,
 * not a resolver: an entry is a fact somebody wrote down, and the dump marks every answer it produces with `origin:
 * library`.
 *
 * Returns are normalised to a raw class: `java.util.stream.Stream<E>` becomes `java.util.stream.Stream`, and primitives
 * or void become unknown — a chain cannot continue through those. The table names no type variable.
 */
public final class LibraryTypes {

    private static final Map<String, Map<String, String>> TABLE = load();

    private LibraryTypes() {
    }

    /**
     * The table ships in the jar, so a missing or unreadable one means the jar is broken: that is fatal, not a dump
     * with every library chain silently unresolved.
     */
    private static Map<String, Map<String, String>> load() {
        Map<String, Map<String, String>> out = new LinkedHashMap<>();
        InputStream resource = LibraryTypes.class.getResourceAsStream("/library-signatures.json");
        if (resource == null) throw new IllegalStateException("library-signatures.json is missing from the jar");
        try (InputStream in = resource) {
            JsonNode root = new ObjectMapper().readTree(in);
            for (var type : root.path("types").properties())
                for (var method : type.getValue().properties())
                    out.computeIfAbsent(type.getKey(), k -> new LinkedHashMap<>())
                            .put(method.getKey(), normalise(method.getValue().asText()));
        } catch (IOException | RuntimeException e) {
            throw new IllegalStateException("library-signatures.json in the engine jar cannot be read", e);
        }
        return out;
    }

    /** How many (type, method) facts the table holds; used by meta so a run says what extension it carried. */
    public static int size() {
        int n = 0;
        for (Map<String, String> m : TABLE.values()) n += m.size();
        return n;
    }

    /** The return type a chain continues through, or null when the table cannot say. */
    public static String returnType(String owner, String name, int argc) {
        if (owner == null || name == null) return null;
        Map<String, String> methods = TABLE.get(raw(owner));
        if (methods == null) return null;
        return methods.get(name + "/" + argc) != null ? methods.get(name + "/" + argc) : methods.get(name);
    }

    /**
     * A type name without generic arguments: what a receiver can be. Primitives and void are no receiver. A name is
     * never judged by its spelling: a type variable is told apart by its reference kind, before it becomes a name.
     */
    public static String raw(String type) {
        if (type == null) return null;
        String text = type.replaceAll("<.*", "").replace("[]", "").trim();
        if (text.isEmpty()) return null;
        if (text.equals("void") || text.equals("boolean") || text.equals("int") || text.equals("long")
                || text.equals("double") || text.equals("float") || text.equals("byte") || text.equals("short")
                || text.equals("char")) return null;
        return text;
    }

    private static String normalise(String returns) {
        String text = returns == null ? null : returns.replace(" ", "");
        if (text == null) return null;
        String raw = raw(text);
        if (raw == null) return null;
        // A table name is always the dotted one; a bare name (a type variable, if one ever slipped in) is no receiver.
        return raw.contains(".") ? raw : null;
    }
}
