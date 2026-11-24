package contract;

public class Fields {
    static final ThreadLocal<String> HOLDER = new ThreadLocal<>();
    private String name;

    void write(String value) {
        this.name = value;
        HOLDER.set(value);
    }

    String read() {
        return name;
    }

    String unknown() {
        stranger.qty = 1;
        return stranger.qty;
    }
}
