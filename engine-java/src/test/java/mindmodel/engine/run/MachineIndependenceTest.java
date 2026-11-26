package mindmodel.engine.run;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The dump is the same wherever the checkout lives: the same inputs copied to two different absolute folders, under
 * different names, dump to byte-identical files. Nothing in an output may name the host, the user, the folder or a
 * time.
 * The inputs carry a classpath, whose entries sit at a different path in each place.
 */
class MachineIndependenceTest {

    @TempDir
    Path dir;

    @Test
    void theSameInputsFromTwoLocationsGiveIdenticalBytes() throws Exception {
        Path first = dumpAt(dir.resolve("first-place").resolve("checkout"));
        Path second = dumpAt(dir.resolve("another").resolve("elsewhere-name"));

        List<String> names = names(first);
        assertEquals(names, names(second), "both dumps write the same files");
        assertTrue(names.contains("meta.json") && names.contains("library.ndjson"), names.toString());
        for (String name : names)
            assertArrayEquals(Files.readAllBytes(first.resolve(name)), Files.readAllBytes(second.resolve(name)),
                    name + " differs between the two locations");
    }

    @Test
    void theClasspathIsRecordedByNameNotByPath() throws Exception {
        Path first = dumpAt(dir.resolve("one").resolve("checkout"));
        String meta = Files.readString(first.resolve("meta.json"));
        assertFalse(meta.contains(dir.toString()), "meta.json names no folder of the host");
        assertTrue(meta.contains("\"entries\" : 1"), "the classpath entry is counted: " + meta);
    }

    /**
     * Known gap, kept as a test so the fix has a target: Spoon keeps one of two declarations of a name by checkout
     * path, so the file it keeps changes with the location. The documented rule is the first file in sorted order.
     * Fixing it changes which declaration three corpus apps keep (a Node snapshot change), so it waits for that
     * decision. SPOON.md records it.
     */
    @Disabled("known gap: Spoon keeps a duplicate declaration by checkout path (SPOON.md)")
    @Test
    void aDuplicateDeclarationIsKeptFromTheSameFileWhereverTheCheckoutLives() throws Exception {
        for (String place : List.of("first/alpha-checkout", "second/zulu-checkout")) {
            Path root = dir.resolve(place);
            Files.createDirectories(root.resolve("a"));
            Files.createDirectories(root.resolve("b"));
            Files.writeString(root.resolve("a/Dup.java"), "package demo; public class Dup { }");
            Files.writeString(root.resolve("b/Dup.java"), "package demo; public class Dup { int other; }");
            Path list = root.resolve("files.txt");
            Files.writeString(list, "a/Dup.java\nb/Dup.java\n");
            Dump.run(root, list, root.resolve("out"), 17, List.of(), List.of());
            String types = Files.readString(root.resolve("out").resolve("types.ndjson"));
            assertTrue(types.contains("\"file\":\"a/Dup.java\""), place + " keeps the sorted-first file: " + types);
        }
    }

    /**
     * Dumps the fixture and the conventions sources under {@code root}, with a compiled library on the classpath that
     * is built inside {@code root} too, so its path differs from one location to the next.
     */
    private static Path dumpAt(Path root) throws IOException {
        Map<String, String> sources = DumpConventionsTest.SOURCES;
        List<String> listed = new ArrayList<>(sources.keySet());
        for (var source : sources.entrySet()) {
            Path file = root.resolve(source.getKey());
            Files.createDirectories(file.getParent());
            Files.writeString(file, source.getValue());
        }
        Path fixture = Path.of("..", "test", "dump-fixture").toAbsolutePath().normalize();
        try (Stream<Path> walk = Files.walk(fixture.resolve("src"))) {
            for (Path p : walk.filter(p -> p.toString().endsWith(".java")).toList()) {
                Path target = root.resolve(fixture.relativize(p).toString());
                Files.createDirectories(target.getParent());
                Files.copy(p, target);
                listed.add(fixture.relativize(p).toString().replace('\\', '/'));
            }
        }
        Path classes = DumpRun.compile(root.resolve("libs"), Map.of("lib/Holder.java", DumpConventionsTest.LIB));
        Path list = root.resolve("files.txt");
        Files.write(list, listed.stream().sorted().toList());
        Path out = root.resolve("out");
        Dump.run(root, list, out, 21, List.of(classes.toString()), List.of());
        return out;
    }

    private static List<String> names(Path out) throws IOException {
        try (Stream<Path> listing = Files.list(out)) {
            return listing.map(p -> p.getFileName().toString()).sorted().toList();
        }
    }
}
