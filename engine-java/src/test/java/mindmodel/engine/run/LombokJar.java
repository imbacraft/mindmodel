package mindmodel.engine.run;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.stream.Stream;

/** The Lombok jar the delombok oracle tests run with: MINDMODEL_LOMBOK_JAR, else the newest one in ~/.m2, else null. */
public final class LombokJar {

    private LombokJar() {
    }

    public static Path find() {
        String env = System.getenv("MINDMODEL_LOMBOK_JAR");
        if (env != null && !env.isBlank()) return Path.of(env);
        Path repo = Path.of(System.getProperty("user.home"), ".m2", "repository", "org", "projectlombok", "lombok");
        if (!Files.isDirectory(repo)) return null;
        try (Stream<Path> files = Files.walk(repo)) {
            return files.filter(p -> p.getFileName().toString().matches("lombok-[0-9.]+\\.jar"))
                    .max(Comparator.naturalOrder()).orElse(null);
        } catch (IOException e) {
            return null;
        }
    }
}
