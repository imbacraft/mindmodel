package orders;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.security.access.prepost.PreAuthorize;

@RestController
@RequestMapping(path = "/api/orders")
public class OrderController {
    @GetMapping("/{id}")
    @PreAuthorize("hasRole('ADMIN')")
    public Order one(@PathVariable("id") Long id) { return new Order(); }

    @PostMapping(value = {"/a", "/b"}, produces = "application/json")
    public Order many(String... names) { return new Order(); }

    @GetMapping("/x") public Order same() { return new Order(); } @GetMapping("/y") public Order same(int n) { return new Order(); }
}
