package mindmodel.engine.dump;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The same inputs dump to the same bytes, whatever the run and whatever order the file list names them in. */
class DeterminismTest {

    @TempDir
    Path dir;

    private static final Map<String, String> SOURCES = Map.of(
            "demo/Caller.java", """
                    package demo;
                    import java.util.ArrayList;
                    import java.util.List;
                    public class Caller {
                        private final Greeter greeter = new Impl();
                        String run(String who) {
                            List<String> names = new ArrayList<>();
                            names.add(who);
                            return greeter.greet(Util.clean(who));
                        }
                    }
                    """,
            "demo/Greeter.java", "package demo; public interface Greeter { String greet(String name); }",
            "demo/Impl.java", "package demo; public class Impl implements Greeter {"
                    + " public String greet(String n) { return n; } }",
            "demo/Util.java", "package demo; public class Util { public static String clean(String s) { return s; } }");

    @Test
    void sameInputsDumpToByteIdenticalFiles() throws Exception {
        DumpRun run = DumpRun.of(dir, SOURCES);
        Path again = run.redump("again", sortedKeys());

        assertSameBytes(run.out, again);
    }

    @Test
    void fileListOrderDoesNotChangeTheDump() throws Exception {
        DumpRun run = DumpRun.of(dir, SOURCES, sortedKeys());
        List<String> reversed = sortedKeys();
        Collections.reverse(reversed);

        assertSameBytes(run.out, run.redump("reversed", reversed));
    }

    private static List<String> sortedKeys() {
        List<String> keys = new ArrayList<>(SOURCES.keySet());
        Collections.sort(keys);
        return keys;
    }

    /** Every file the first dump wrote exists in the second with the same bytes. */
    private static void assertSameBytes(Path first, Path second) throws IOException {
        List<String> names;
        try (Stream<Path> listing = Files.list(first)) {
            names = listing.map(p -> p.getFileName().toString()).sorted().toList();
        }
        assertTrue(names.contains("meta.json"), "the dump wrote its meta.json");
        for (String name : names) assertArrayEquals(Files.readAllBytes(first.resolve(name)),
                Files.readAllBytes(second.resolve(name)), name + " differs between the two dumps");
    }
}
