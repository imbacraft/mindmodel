package contract;

import java.util.function.Function;

public class Lambdas {
    private final Sink sink = new Sink();

    void run() {
        sink.each(item -> sink.take(item));
        Function<Sink, String> named = Sink::name;
        sink.take(named);
        sink.take(this::helper);
        sink.take(String::trim);
    }

    String helper() { return "h"; }
}
