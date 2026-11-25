package mindmodel.engine.cli;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;

import mindmodel.engine.model.SourceModel;
import mindmodel.engine.run.Dump;
import mindmodel.engine.write.Contract;

/**
 * The command line: {@code dump [--contract N] [--compliance L] [--classpath FILE] [--generated FILE] <root>
 * <file-list> <out-dir>} writes the dump, and {@code version} prints the contract. Bad arguments are a usage message
 * and exit 2; a failed run is exit 1.
 */
public final class Main {

    private Main() {
    }

    public static void main(String[] args) {
        try {
            if (args.length >= 1 && "version".equals(args[0])) {
                System.out.println("{\"contract\":" + Contract.CONTRACT + ",\"engine\":\"" + Contract.ENGINE + "\"}");
                return;
            }
            if (args.length >= 1 && "dump".equals(args[0])) {
                dump(args);
                return;
            }
            usage();
        } catch (IOException | RuntimeException e) {
            System.err.println("mindmodel-engine: " + e.getClass().getSimpleName() + ": " + e.getMessage());
            System.exit(1);
        }
    }

    private static void dump(String[] args) throws IOException {
        List<String> rest = new ArrayList<>(List.of(args).subList(1, args.length));
        int contract = Contract.CONTRACT;
        int compliance = SourceModel.compliance();
        List<String> classpath = List.of();
        List<String> generated = List.of();
        while (rest.size() >= 3 && rest.get(0).startsWith("--")) {
            String flag = rest.get(0);
            if ("--contract".equals(flag)) contract = number(rest.get(1));
            else if ("--compliance".equals(flag)) compliance = number(rest.get(1));
            else if ("--classpath".equals(flag)) classpath = lines(rest.get(1));
            else if ("--generated".equals(flag)) generated = lines(rest.get(1));
            else usage();
            rest = new ArrayList<>(rest.subList(2, rest.size()));
        }
        if (contract != Contract.CONTRACT) {
            System.err.println("mindmodel-engine: contract mismatch: asked " + contract + ", engine speaks "
                    + Contract.CONTRACT);
            System.exit(2);
        }
        if (rest.size() != 3) usage();
        Dump.run(Paths.get(rest.get(0)), Paths.get(rest.get(1)), Paths.get(rest.get(2)), compliance, classpath,
                generated);
    }

    /** A numeric flag's value. Text that is no number is a usage error (exit 2), not a crash. */
    private static int number(String text) {
        try {
            return Integer.parseInt(text);
        } catch (NumberFormatException e) {
            usage();
            return -1;
        }
    }

    /** A flag's file argument: one entry per line, blank lines dropped, order kept (the classpath's order is fixed). */
    private static List<String> lines(String file) throws IOException {
        List<String> out = new ArrayList<>();
        for (String line : Files.readAllLines(Paths.get(file), StandardCharsets.UTF_8))
            if (!line.trim().isEmpty()) out.add(line.trim());
        return out;
    }

    private static void usage() {
        System.err.println("usage: java -jar mindmodel-engine.jar version");
        System.err.println("       java -jar mindmodel-engine.jar dump [--contract N] [--compliance L]"
                + " [--classpath FILE] [--generated FILE] <root> <file-list> <out-dir>");
        System.exit(2);
    }
}
