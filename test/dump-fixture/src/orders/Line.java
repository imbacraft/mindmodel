package orders;

public record Line(String sku, int qty) {
    public Line {
        if (qty < 0) throw new IllegalArgumentException("qty");
    }
}
