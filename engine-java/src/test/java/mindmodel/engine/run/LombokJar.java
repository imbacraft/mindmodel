package mindmodel.engine.run;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.stream.Stream;

/**
 * The Lombok jar the delombok oracle tests run with: MINDMODEL_LOMBOK_JAR, else the newest one in the plugin's cache
 * (~/.cache/mindmodel/lombok/VERSION/lombok.jar), else the newest one in ~/.m2, else null.
 */
public final class LombokJar {

    private LombokJar() {
    }

    public static Path find() {
        String env = System.getenv("MINDMODEL_LOMBOK_JAR");
        if (env != null && !env.isBlank()) return Path.of(env);
        Path home = Path.of(System.getProperty("user.home"));
        Path cached = newest(home.resolve(".cache/mindmodel/lombok"), "lombok.jar", 2);
        if (cached != null) return cached;
        Path m2 = home.resolve(".m2/repository/org/projectlombok/lombok");
        return newest(m2, "lombok-[0-9.]+\\.jar", Integer.MAX_VALUE);
    }

    /** The newest file of this name at most {@code depth} folders under {@code dir}, or null. */
    private static Path newest(Path dir, String name, int depth) {
        if (!Files.isDirectory(dir)) return null;
        try (Stream<Path> files = Files.walk(dir, depth)) {
            return files.filter(p -> p.getFileName().toString().matches(name) && Files.isRegularFile(p))
                    .max(Comparator.naturalOrder()).orElse(null);
        } catch (IOException e) {
            return null;
        }
    }
}
