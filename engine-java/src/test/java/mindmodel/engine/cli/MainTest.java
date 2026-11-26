package mindmodel.engine.cli;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import mindmodel.engine.write.Contract;

/**
 * The CLI's output and exit codes (CONTRACT.md, Command line): 0 for success and the two informational flags, 2 for a
 * usage error, 1 for a failed run. Runs Main in a child JVM.
 */
class MainTest {

    @TempDir
    Path dir;

    private static String[] run(String... args) throws IOException, InterruptedException {
        String javaBin = Path.of(System.getProperty("java.home"), "bin", "java").toString();
        List<String> command = new ArrayList<>(List.of(javaBin, "-cp", System.getProperty("java.class.path"),
                "mindmodel.engine.cli.Main"));
        command.addAll(List.of(args));
        Process process = new ProcessBuilder(command).redirectErrorStream(true).start();
        String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        return new String[] {String.valueOf(process.waitFor()), output};
    }

    @Test
    void aNonNumericContractIsAUsageErrorNotACrash() throws Exception {
        String[] result = run("dump", "--contract", "x", "root", "list", "out");
        assertEquals("2", result[0]);
        assertTrue(result[1].contains("usage:"), result[1]);
    }

    @Test
    void aNonNumericCompliancePrintsUsageAndExitsTwo() throws Exception {
        String[] result = run("dump", "--compliance", "twenty", "root", "list", "out");
        assertEquals("2", result[0]);
        assertTrue(result[1].contains("usage:"), result[1]);
    }

    @Test
    void versionPrintsTheEngineVersionAndTheContract() throws Exception {
        String[] result = run("--version");
        assertEquals("0", result[0]);
        assertEquals("mindmodel-engine " + Contract.VERSION + " contract " + Contract.CONTRACT + "\n", result[1]);
        assertTrue(Contract.VERSION.matches("\\d+\\.\\d+\\.\\d+"), "a dotted version: " + Contract.VERSION);
    }

    @Test
    void helpPrintsTheUsageAndExitsZero() throws Exception {
        String[] result = run("--help");
        assertEquals("0", result[0]);
        assertTrue(result[1].startsWith("usage: mindmodel-engine --version"), result[1]);
    }

    @Test
    void noArgumentsIsAUsageError() throws Exception {
        String[] result = run();
        assertEquals("2", result[0]);
        assertTrue(result[1].contains("usage:"), result[1]);
    }

    @Test
    void aContractTheEngineDoesNotSpeakIsAUsageError() throws Exception {
        String[] result = run("dump", "--contract", String.valueOf(Contract.CONTRACT + 1), "root", "list", "out");
        assertEquals("2", result[0]);
        assertTrue(result[1].contains("contract mismatch"), result[1]);
    }

    /** `--lombok JAR` takes its argument: the dump runs, and meta.json says the jar was not there. */
    @Test
    void theLombokFlagTakesAJarAndMetaSaysWhyItWasNotUsed() throws Exception {
        Path root = dir.resolve("src");
        Files.createDirectories(root.resolve("demo"));
        Files.writeString(root.resolve("demo/Tagged.java"),
                "package demo;\nimport lombok.ToString;\n@ToString public class Tagged { int x; }\n");
        Path list = dir.resolve("files.txt");
        Files.writeString(list, "demo/Tagged.java\n");
        Path out = dir.resolve("out");

        String[] result = run("dump", "--lombok", dir.resolve("no-such.jar").toString(), root.toString(),
                list.toString(), out.toString());

        assertEquals("0", result[0], result[1]);
        JsonNode lombok = new ObjectMapper().readTree(out.resolve("meta.json").toFile()).path("lombok");
        assertEquals("hand", lombok.path("mode").asText(), lombok.toString());
        assertEquals("the lombok jar is not a readable file", lombok.path("reason").asText(), lombok.toString());
    }

    @Test
    void aRunThatCannotReadItsInputsFailsWithExitOne() throws Exception {
        String[] result = run("dump", dir.resolve("no-root").toString(), dir.resolve("no-list.txt").toString(),
                dir.resolve("out").toString());
        assertEquals("1", result[0]);
        assertTrue(result[1].startsWith("mindmodel-engine: "), result[1]);
    }
}
