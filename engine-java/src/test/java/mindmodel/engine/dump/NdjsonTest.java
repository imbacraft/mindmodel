package mindmodel.engine.dump;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.nio.file.Files;
import java.nio.file.Path;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** A row is written whole or not at all: one that fails half-way leaves no partial object for the next row to follow. */
class NdjsonTest {

    @TempDir
    Path dir;

    @Test
    void aRowThatFailsHalfWayLeavesNothingBehind() throws Exception {
        Path file = dir.resolve("rows.ndjson");
        try (Ndjson w = new Ndjson(file)) {
            w.row(g -> g.writeStringField("a", "1"));
            assertThrows(IllegalStateException.class, () -> w.row(g -> {
                g.writeStringField("partial", "x");
                throw new IllegalStateException("boom");
            }));
            w.row(g -> g.writeStringField("b", "2"));
        }

        assertEquals("{\"a\":\"1\"}\n{\"b\":\"2\"}", Files.readString(file));
    }
}
