package contract;

public class Args {
    static final String NAME = "name";

    private final Sink sink = new Sink();
    private String state;

    void run(String input, int count) {
        String local = input.trim();
        sink.take(NAME);
        sink.take("literal");
        sink.take(input);
        sink.take(local);
        sink.take(state);
        sink.take(sink.name());
        sink.take(() -> "x");
        sink.take(this::helper);
        sink.take(new Sink());
        sink.take(input.length());
        sink.take(mystery.port);
        sink.take(input == null ? NAME : state);
        sink.take(count);
    }

    String helper() { return NAME; }
}
