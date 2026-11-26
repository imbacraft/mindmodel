package mindmodel.engine.model;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import mindmodel.engine.run.DumpRun;

/**
 * A source that is not UTF-8 (a Latin-1 or Windows-1252 file from an old checkout). Spoon reads the original text with
 * the environment's one encoding, strictly, and would throw; the dump reads such a file as ISO-8859-1 and counts it.
 */
class SourceEncodingTest {

    @TempDir
    Path dir;

    /** A Latin-1 file: `é` is the byte 0xE9 in the constant and in the comment, and the header has an import. */
    private static final String LATIN1 = "package demo;\n"
            + "import java.util.List;\n"
            + "// café\n"
            + "public class Latin {\n"
            + "    public static final String NAME = \"café\";\n"
            + "    List<String> names() { return null; }\n"
            + "}\n";

    private static void writeLatin1(Path root, String rel, String text) throws Exception {
        Path file = root.resolve(rel);
        Files.createDirectories(file.getParent());
        Files.write(file, text.getBytes(StandardCharsets.ISO_8859_1));
    }

    @Test
    void aLatin1SourceDoesNotAbortTheDumpAndItsTextReadsAsWritten() throws Exception {
        writeLatin1(dir.resolve("src"), "demo/Latin.java", LATIN1);

        DumpRun run = DumpRun.of(dir, Map.of(), List.of("demo/Latin.java"));

        JsonNode name = DumpRun.one(run.rows("members"), "name", "NAME");
        assertEquals("café", name.path("value").path("value").asText());
        assertEquals("NAME", name.path("name").asText());
        int col = LATIN1.split("\n")[4].indexOf("NAME") + 1;
        assertEquals(col, name.path("pos").path("col").asInt(), "a column counts the characters, not the bytes");
        assertEquals("java.util.List", run.rows("files").get(0).path("imports").get(0).path("name").asText());
        assertEquals(1, run.meta().path("counts").path("files.notUtf8").asInt());
    }

    @Test
    void aUtf8SourceIsReadAsUtf8AndIsNotCounted() throws Exception {
        String utf8 = LATIN1.replace("café", "café");
        Path file = dir.resolve("src/demo/Latin.java");
        Files.createDirectories(file.getParent());
        Files.writeString(file, utf8, StandardCharsets.UTF_8);

        DumpRun run = DumpRun.of(dir, Map.of(), List.of("demo/Latin.java"));

        JsonNode name = DumpRun.one(run.rows("members"), "name", "NAME");
        assertEquals("café", name.path("value").path("value").asText());
        assertFalse(run.meta().path("counts").has("files.notUtf8"), run.meta().toString());
        assertTrue(run.rows("files").get(0).path("errors").isEmpty());
    }

    @Test
    void aLatin1FileBesideAUtf8FileKeepsBothTexts() throws Exception {
        writeLatin1(dir.resolve("src"), "demo/Latin.java", LATIN1);
        Path utf8 = dir.resolve("src/demo/Other.java");
        Files.writeString(utf8, "package demo;\npublic class Other { public static final String S = \"€\"; }\n",
                StandardCharsets.UTF_8);

        DumpRun run = DumpRun.of(dir, Map.of(), List.of("demo/Latin.java", "demo/Other.java"));

        assertEquals("café", DumpRun.one(run.rows("members"), "name", "NAME").path("value").path("value").asText());
        assertEquals("€", DumpRun.one(run.rows("members"), "name", "S").path("value").path("value").asText());
        assertEquals(1, run.meta().path("counts").path("files.notUtf8").asInt());
    }
}
