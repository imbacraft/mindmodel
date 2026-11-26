package mindmodel.engine.model;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;

/**
 * Lombok's delombok, run over the Lombok-using sources only, into a temporary folder that {@link #close} removes. The
 * run is a child JVM (`java -jar lombok.jar delombok`), not Lombok loaded into this one: Lombok reaches into javac's
 * internals, which a child can do without this engine's classpath, and a hang or a crash stays in the child. The
 * sources are copied into a staging folder with the lombok.config files above them, so Lombok finds the same config
 * it finds in the checkout, and nothing else of the checkout is read or written.
 */
public final class Delombok implements AutoCloseable {

    /** Long enough for a large checkout; a delombok that runs past it is a failure, not a wait. */
    private static final long TIMEOUT_SECONDS = 300;

    private final Path work;
    private final Path out;
    private final String error;

    private Delombok(Path work, Path out, String error) {
        this.work = work;
        this.out = out;
        this.error = error;
    }

    /** The folder delomboked files were written to, at their project-relative paths; null on {@link #error}. */
    public Path out() {
        return out;
    }

    /** Why delombok did not run to completion, with no absolute path in it; null when it did. */
    public String error() {
        return error;
    }

    /**
     * Delomboks the files (project-relative, under {@code root}) with the Lombok jar. {@code classpath} is the
     * project's own dependency entries, which Lombok resolves annotations and superclasses against.
     */
    public static Delombok run(Path root, List<String> files, Path jar, List<String> classpath) throws IOException {
        Path work = Files.createTempDirectory("mindmodel-delombok");
        try {
            if (!Files.isRegularFile(jar) || !Files.isReadable(jar))
                return new Delombok(work, null, "the lombok jar is not a readable file");
            Path src = work.resolve("src");
            Path out = work.resolve("out");
            stage(root, files, src);
            String error = execute(jar, src, out, classpath, work);
            return new Delombok(work, error == null ? out : null, error);
        } catch (IOException | RuntimeException e) {
            new Delombok(work, null, null).close();
            throw e;
        }
    }

    /** Copies each file, and each lombok.config from its folder up to the checkout root, into the staging folder. */
    static void stage(Path root, List<String> files, Path src) throws IOException {
        Set<String> configs = new TreeSet<>();
        for (String rel : files) {
            Path target = src.resolve(rel);
            Files.createDirectories(target.getParent());
            Files.copy(root.resolve(rel), target);
            for (Path dir = root.resolve(rel).getParent(); dir != null && dir.startsWith(root); dir = dir.getParent()) {
                String config = root.relativize(dir).resolve("lombok.config").toString();
                if (configs.add(config) && Files.isRegularFile(dir.resolve("lombok.config"))) {
                    Path copy = src.resolve(config);
                    Files.createDirectories(copy.getParent());
                    Files.copy(dir.resolve("lombok.config"), copy);
                }
            }
        }
    }

    /** Runs the child JVM; null on success, else the reason. Every file delombok was asked for must come back. */
    private static String execute(Path jar, Path src, Path out, List<String> classpath, Path work) throws IOException {
        List<String> cp = new ArrayList<>();
        cp.add(jar.toString());
        cp.addAll(classpath);
        List<String> command = List.of(javaBinary(), "-jar", jar.toString(), "delombok", "-n", "-q", "-e", "UTF-8",
                "-c", String.join(File.pathSeparator, cp), "-d", out.toString(), src.toString());
        Path log = work.resolve("delombok.log");
        Process process = new ProcessBuilder(command).redirectErrorStream(true)
                .redirectOutput(log.toFile()).start();
        try {
            if (!process.waitFor(TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                process.destroyForcibly();
                return "delombok did not finish in " + TIMEOUT_SECONDS + " seconds";
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return "delombok was interrupted";
        }
        if (process.exitValue() != 0) return "delombok exited " + process.exitValue() + ": " + firstLine(log);
        return missingOutput(src, out);
    }

    /** The first staged source delombok did not write, or null when each has its output (configs are not written). */
    private static String missingOutput(Path src, Path out) throws IOException {
        try (Stream<Path> staged = Files.walk(src)) {
            for (Path file : staged.filter(f -> Files.isRegularFile(f) && f.toString().endsWith(".java")).sorted()
                    .toList()) {
                Path written = out.resolve(src.relativize(file));
                if (!Files.isRegularFile(written)) return "delombok wrote no file for " + src.relativize(file);
            }
        }
        return null;
    }

    private static String javaBinary() {
        return Path.of(System.getProperty("java.home"), "bin", "java").toString();
    }

    /** The first line of delombok's output, scrubbed and cut: the reason an error names, with no path in it. */
    private static String firstLine(Path log) {
        String text = SourceText.read(log);
        if (text != null)
            for (String line : text.split("\n"))
                if (!line.isBlank() && !line.startsWith("WARNING")) {
                    String cut = Failures.scrub(line.trim());
                    return cut.length() > 200 ? cut.substring(0, 200) : cut;
                }
        return "no output";
    }

    /** Removes the temporary folder, staged sources and delomboked output with it. */
    @Override
    public void close() throws IOException {
        if (!Files.exists(work)) return;
        try (Stream<Path> all = Files.walk(work)) {
            for (Path p : all.sorted((a, b) -> b.getNameCount() - a.getNameCount()).toList()) Files.deleteIfExists(p);
        }
    }
}
