package mindmodel.engine.dump;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Path;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.stream.StreamSupport;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;


/** library.ndjson: a classpath type's shallow rows, spelled the way Java spells them whatever the locale. */
class LibraryStubsTest {

    @TempDir
    Path dir;

    private static final String HOLDER = """
            package lib;
            public class Holder<T> {
                public T value;
                private int secret;
                public T get() { return value; }
            }
            """;

    private static final String USE = """
            package demo;
            import lib.Holder;
            public class Use {
                Holder<String> held;
                void m(Holder<String> x) { x.get(); }
            }
            """;

    private static JsonNode field(JsonNode type, String name) {
        return StreamSupport.stream(type.path("fields").spliterator(), false)
                .filter(f -> name.equals(f.path("name").asText())).findFirst()
                .orElseThrow(() -> new AssertionError("no field " + name));
    }

    /** Turkish folds `I` to a dotless i: a case-folded `PRIVATE` would be spelled `prıvate`. */
    @Test
    void libraryModifiersAreJavaSpelledInAnyLocale() throws Exception {
        Path classes = DumpRun.compile(dir, Map.of("lib/Holder.java", HOLDER));
        Locale before = Locale.getDefault();
        Locale.setDefault(Locale.forLanguageTag("tr-TR"));
        JsonNode holder;
        try {
            holder = DumpRun.one(libraryRows(classes), "fqn", "lib.Holder");
        } finally {
            Locale.setDefault(before);
        }
        assertTrue(StreamSupport.stream(field(holder, "secret").path("modifiers").spliterator(), false)
                .anyMatch(m -> "private".equals(m.asText())), "private is spelled private");
    }

    /** A field whose type is a type variable names no type, so its typeFqn is empty rather than the variable's name. */
    @Test
    void aTypeVariableFieldHasNoTypeKey() throws Exception {
        Path classes = DumpRun.compile(dir, Map.of("lib/Holder.java", HOLDER));
        JsonNode holder = DumpRun.one(libraryRows(classes), "fqn", "lib.Holder");
        assertEquals("", field(holder, "value").path("typeFqn").asText(), "T is no type: the key is empty, not T");
    }

    private List<JsonNode> libraryRows(Path classes) throws IOException {
        return DumpRun.of(dir.resolve("run"), Map.of("demo/Use.java", USE), List.of("demo/Use.java"), 17,
                List.of(classes.toString())).rows("library");
    }
}
