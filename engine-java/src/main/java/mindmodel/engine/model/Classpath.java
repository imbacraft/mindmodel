package mindmodel.engine.model;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.zip.ZipFile;

/**
 * The classpath entries Spoon can read, checked one by one before the model is built. Spoon refuses the whole classpath
 * when one entry is missing, so a missing or unreadable entry is dropped here, counted, and named in meta.json by its
 * file name: the entries that read still do their work.
 */
public final class Classpath {

    /** One entry the run dropped: its file name (never its path) and why. */
    public record Dropped(String name, String reason) {
    }

    private Classpath() {
    }

    /**
     * The entries that can be read, in the order given. A folder must exist; a jar must exist and open as a zip. Every
     * other entry is added to {@code dropped} and counted under {@code CLASSPATH_UNREADABLE}.
     */
    public static List<String> readable(List<String> entries, List<Dropped> dropped, Failures failures) {
        List<String> out = new ArrayList<>();
        for (String entry : entries) {
            Path p = Path.of(entry);
            String name = p.getFileName() == null ? entry : p.getFileName().toString();
            String reason = unreadableReason(p);
            if (reason == null) {
                out.add(entry);
            } else {
                dropped.add(new Dropped(name, reason));
                failures.count(Failures.Key.CLASSPATH_UNREADABLE);
            }
        }
        return out;
    }

    /** Why an entry cannot be read, or null when it can. */
    static String unreadableReason(Path p) {
        if (!Files.exists(p)) return "missing";
        if (Files.isDirectory(p)) return Files.isReadable(p) ? null : "unreadable";
        if (!Files.isRegularFile(p) || !Files.isReadable(p)) return "unreadable";
        if (!p.getFileName().toString().endsWith(".jar")) return null;
        try (ZipFile zip = new ZipFile(p.toFile())) {
            return null;
        } catch (java.io.IOException e) {
            return "not a zip archive";
        }
    }

    /** Self-checks: run on import. */
    static {
        assert unreadableReason(Path.of("/no/such/entry.jar")).equals("missing");
    }
}
