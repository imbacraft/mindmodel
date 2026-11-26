package mindmodel.engine.model;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assumptions.assumeFalse;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import mindmodel.engine.run.DumpRun;

/** An input that cannot be opened is counted and left out; the rest of the checkout is dumped. */
class UnreadableInputTest {

    @TempDir
    Path dir;

    @Test
    void anUnopenableSourceIsCountedAndTheRestIsDumped() throws Exception {
        Path locked = dir.resolve("src/demo/Locked.java");
        Files.createDirectories(locked.getParent());
        Files.writeString(locked, "package demo; public class Locked { void g() {} }");
        Files.writeString(dir.resolve("src/demo/Good.java"), "package demo; public class Good { void g() {} }");
        Files.setPosixFilePermissions(locked, PosixFilePermissions.fromString("---------"));
        try {
            assumeFalse(Files.isReadable(locked), "this process can read a file with no permissions (root)");

            DumpRun run = DumpRun.of(dir, Map.of(), List.of("demo/Good.java", "demo/Locked.java"));

            JsonNode meta = run.meta();
            assertEquals(1, meta.path("counts").path("files.unreadable").asInt(), meta.toString());
            assertEquals(1, meta.path("counts").path("files").asInt());
            assertEquals(List.of("demo/Good.java"),
                    run.rows("files").stream().map(f -> f.path("path").asText()).toList());
        } finally {
            Files.setPosixFilePermissions(locked, PosixFilePermissions.fromString("rw-r--r--"));
        }
    }
}
