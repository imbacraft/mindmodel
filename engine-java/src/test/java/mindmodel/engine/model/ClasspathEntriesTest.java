package mindmodel.engine.model;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import mindmodel.engine.run.DumpRun;

/** A classpath entry that is missing or unreadable is dropped and counted; the entries that read still do. */
class ClasspathEntriesTest {

    @TempDir
    Path dir;

    private static final String LIB = "package demo.lib; public class Lib {"
            + " public static String hello() { return \"hi\"; } }";
    private static final String USE = "package demo; import demo.lib.Lib; public class Use {"
            + " String f() { return Lib.hello(); } }";

    @Test
    void aMissingAndAnUnreadableEntryAreDroppedAndCountedAndTheRestStillRead() throws Exception {
        Path classes = DumpRun.compile(dir, Map.of("demo/lib/Lib.java", LIB));
        Path corrupt = dir.resolve("corrupt.jar");
        Files.writeString(corrupt, "this is not a zip archive");
        List<String> classpath = List.of(dir.resolve("missing.jar").toString(), corrupt.toString(), classes.toString());

        DumpRun run = DumpRun.of(dir, Map.of("demo/Use.java", USE), List.of("demo/Use.java"),
                SourceModel.compliance(), classpath);

        JsonNode meta = run.meta();
        assertEquals(2, meta.path("counts").path("classpath.unreadable").asInt(), meta.toString());
        assertFalse(meta.path("classpath").has("dropped"), "one bad entry must not drop the whole classpath");
        assertEquals(1, meta.path("classpath").path("libraryTypes").asInt(), meta.toString());
        JsonNode listed = meta.path("classpath").path("unreadable");
        assertEquals(List.of("missing.jar", "corrupt.jar"),
                List.of(listed.get(0).path("name").asText(), listed.get(1).path("name").asText()),
                "entries are listed in classpath order, by file name, never by path");
        assertEquals("missing", listed.get(0).path("reason").asText());
        assertEquals("not a zip archive", listed.get(1).path("reason").asText());
    }

    @Test
    void aCleanClasspathWritesNoUnreadableKey() throws Exception {
        Path classes = DumpRun.compile(dir, Map.of("demo/lib/Lib.java", LIB));

        JsonNode meta = DumpRun.of(dir, Map.of("demo/Use.java", USE), List.of("demo/Use.java"),
                SourceModel.compliance(), List.of(classes.toString())).meta();

        assertFalse(meta.path("counts").has("classpath.unreadable"), meta.toString());
        assertFalse(meta.path("classpath").has("unreadable"), meta.toString());
    }
}
