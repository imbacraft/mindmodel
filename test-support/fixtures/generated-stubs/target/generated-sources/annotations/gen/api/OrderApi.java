package gen.api;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;

/** Written by an annotation processor: the project's controllers implement it and inherit its mappings. */
public interface OrderApi {

    String BASE = "/orders";

    @GetMapping(BASE)
    Object list();

    @GetMapping(BASE + "/{id}")
    Object one(@PathVariable("id") Long id);

    @PostMapping(BASE)
    Object create(Object body);
}
