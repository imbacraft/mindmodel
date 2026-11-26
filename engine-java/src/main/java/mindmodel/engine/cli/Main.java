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
 * The command line. {@code --version} prints the engine version and the contract number; {@code --help} prints the
 * usage. {@code dump [--contract N] [--compliance L] [--classpath FILE] [--generated FILE] <root> <file-list>
 * <out-dir>} writes the dump. Exit codes: 0 for success and for the two informational flags, 2 for a usage error
 * (bad arguments, or a contract number the engine does not speak), 1 for a failed run. CONTRACT.md documents them.
 */
public final class Main {

    /** The usage text: printed by {@code --help} on stdout, and on stderr with exit 2 after a usage error. */
    static final String USAGE = "usage: mindmodel-engine --version\n"
            + "       mindmodel-engine --help\n"
            + "       mindmodel-engine dump [--contract N] [--compliance L] [--classpath FILE] [--generated FILE]\n"
            + "                      <root> <file-list> <out-dir>\n";

    private Main() {
    }

    public static void main(String[] args) {
        try {
            if (args.length == 1 && "--version".equals(args[0])) {
                System.out.println("mindmodel-engine " + Contract.VERSION + " contract " + Contract.CONTRACT);
                return;
            }
            if (args.length == 1 && "--help".equals(args[0])) {
                System.out.print(USAGE);
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
        System.err.print(USAGE);
        System.exit(2);
    }
}
