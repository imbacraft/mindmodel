package mindmodel.engine;

import java.io.IOException;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;

import mindmodel.engine.dump.Dump;

/**
 * CLI: {@code dump [--contract N] [--compliance L] [--classpath FILE] [--generated FILE] <root> <file-list>
 * <out-dir>} writes the typed model, and
 * {@code version} prints the contract. There is no second command: Node reads the dump, and the call-answering CLI went
 * with the resolver it served.
 */
public final class Main {

    private Main() {
    }

    public static void main(String[] args) {
        try {
            if (args.length >= 1 && "version".equals(args[0])) {
                System.out.println("{\"contract\":" + Dump.CONTRACT + ",\"engine\":\"" + Dump.ENGINE + "\"}");
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
        int contract = Dump.CONTRACT;
        int compliance = SourceModel.compliance();
        List<String> classpath = List.of();
        List<String> generated = List.of();
        while (rest.size() >= 3 && rest.get(0).startsWith("--")) {
            String flag = rest.get(0);
            if ("--contract".equals(flag)) contract = Integer.parseInt(rest.get(1));
            else if ("--compliance".equals(flag)) compliance = Integer.parseInt(rest.get(1));
            else if ("--classpath".equals(flag)) classpath = lines(rest.get(1));
            else if ("--generated".equals(flag)) generated = lines(rest.get(1));
            else usage();
            rest = new ArrayList<>(rest.subList(2, rest.size()));
        }
        if (contract != Dump.CONTRACT) {
            System.err.println("mindmodel-engine: contract mismatch: asked " + contract + ", engine speaks "
                    + Dump.CONTRACT);
            System.exit(2);
        }
        if (rest.size() != 3) usage();
        Dump.run(Paths.get(rest.get(0)), Paths.get(rest.get(1)), Paths.get(rest.get(2)), compliance, classpath,
                generated);
    }

    /** A flag's file argument: one entry per line, blank lines dropped, order kept (the classpath's order is fixed). */
    private static List<String> lines(String file) throws IOException {
        List<String> out = new ArrayList<>();
        for (String line : java.nio.file.Files.readAllLines(Paths.get(file), java.nio.charset.StandardCharsets.UTF_8))
            if (!line.trim().isEmpty()) out.add(line.trim());
        return out;
    }

    private static void usage() {
        System.err.println("usage: java -jar mindmodel-engine.jar version");
        System.err.println("       java -jar mindmodel-engine.jar dump [--contract N] [--compliance L] [--classpath FILE]"
                + " [--generated FILE] <root> <file-list> <out-dir>");
        System.exit(2);
    }
}
