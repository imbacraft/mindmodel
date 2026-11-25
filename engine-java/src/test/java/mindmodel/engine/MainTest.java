package mindmodel.engine;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import org.junit.jupiter.api.Test;

/** The CLI's bad arguments: a usage message and exit 2, never a crash (exit 1). Runs Main in a child JVM. */
class MainTest {

    private static String[] run(String... args) throws IOException, InterruptedException {
        String javaBin = Path.of(System.getProperty("java.home"), "bin", "java").toString();
        List<String> command = new ArrayList<>(List.of(javaBin, "-cp", System.getProperty("java.class.path"),
                "mindmodel.engine.Main"));
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
}
